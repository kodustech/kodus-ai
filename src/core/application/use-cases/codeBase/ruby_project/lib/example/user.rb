require 'securerandom'

# Require relativo do mesmo diretório
require_relative 'base_model'

# Require relativo de subdiretório
require_relative 'validators/email'

module Example
  class User < BaseModel
    include Validators::Email
    
    attr_reader :id, :name, :email
    
    def initialize(name, email)
      @id = SecureRandom.uuid
      @name = name
      @email = email
    end
    
    def valid?
      valid_email?(@email)
    end
  end
end
